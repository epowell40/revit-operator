import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { inspectDraftingVectorSource, pageDraftingVectorSource, selectDraftingVectorSource, type DraftingVectorSourceInput } from "../src/pdf/drafting_vector_source.js";

// Synthetic unmarked PDF in memory: no office/project fixtures or inferred Revit IDs.
function pdf(stream:string,options:{rotation?:number;form?:string;extGState?:string}={}){
  const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate ${options.rotation??0} /Resources << /Font << /F1 4 0 R >> ${options.form?"/XObject << /X1 6 0 R >>":""} ${options.extGState?`/ExtGState << /GS1 ${options.form?7:6} 0 R >>`:""} >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  if(options.form)objects.push(`<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /Matrix [1 0 0 1 20 10] /Length ${Buffer.byteLength(options.form)} >>\nstream\n${options.form}\nendstream`);
  if(options.extGState)objects.push(options.extGState);
  let body="%PDF-1.4\n";const offsets=[0];
  for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
  const xref=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const n of offsets.slice(1))body+=String(n).padStart(10,"0")+" 00000 n \n";
  body+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return new Uint8Array(Buffer.from(body));
}
const sha=(b:Uint8Array)=>crypto.createHash("sha256").update(b).digest("hex");
async function inspect(stream:string,override:Partial<DraftingVectorSourceInput>={},options:Parameters<typeof pdf>[1]={}){
  const bytes=pdf(stream,options);return inspectDraftingVectorSource(bytes,{expectedSourceSha256:sha(bytes),page:1,region:[0,0,200,100],sourceLabel:"Reference detail.pdf",sourceSheet:"M101",...override});
}

test("unmarked paths retain exact transformed lines, cubic controls and stable source identities",async()=>{
  const stream="q 2 0 0 2 10 5 cm 1 2 m 4 2 l 5 3 6 4 7 5 c S Q";
  const a=await inspect(stream),b=await inspect(stream);
  assert.equal(a.paths.length,1);assert.deepEqual(a,b);
  const cs=a.paths[0].contours[0].commands;
  assert.deepEqual(cs[1],{kind:"line",start:[12,91],end:[18,91]});
  assert.deepEqual(cs[2],{kind:"cubic_bezier",start:[18,91],controlPoints:[[20,89],[22,87]],end:[24,85]});
  assert.equal(a.nativeWriteAllowed,false);assert.equal(a.sourceReadTruncated,false);
  assert.equal(a.coordinateSpace,"top-origin rotated PDF paper points");
  assert.equal(a.sourceSheet,"M101");assert.doesNotMatch(JSON.stringify(a),/elementId|engineeringScale/);
});
test("distinct contours in one paint group can omit old revision marks without dropping adjacent detail",async()=>{
  const a=await inspect("10 10 m 30 10 l 30 30 l S 50 10 m 70 10 l 70 30 l h 100 10 m 120 10 l S");
  const group=a.paths[1];assert.equal(group.contours.length,2);
  const selected=selectDraftingVectorSource(a,a.planSha256,[{recordId:group.contours[0].id,reason:"historical_revision",evidence:"Source overview: old revision cloud, outside new project revision scope."}]);
  assert.equal(selected.paths.length,2);assert.equal(selected.paths[1].contours.length,1);
  assert.deepEqual(selected.paths[0],a.paths[0]);assert.deepEqual(selected.paths[1].contours[0],group.contours[1]);
  assert.equal(a.paths[1].contours.length,2);assert.equal(selected.omissions.length,1);assert.equal(selected.nativeWriteAllowed,false);
});
test("a crop retains crossing contours and off-region siblings; no silent whole-group dropping or clipping",async()=>{
  const a=await inspect("0 50 m 100 50 l 150 50 m 190 50 l S",{region:[20,20,80,80]});
  assert.equal(a.paths.length,1);assert.equal(a.paths[0].contours.length,2);
  assert.equal(a.paths[0].contours[0].crossesRegion,true);assert.equal(a.paths[0].contours[1].intersectsRegion,false);
  assert.deepEqual(a.paths[0].contours[0].commands[1],{kind:"line",start:[0,50],end:[100,50]});
  assert(a.conversionRequirements.includes("clip_crossing_contours_to_selected_region"));
});
test("source zero-length commands survive inspection rather than silently disappearing",async()=>{
  const a=await inspect("10 10 m 10 10 l 20 10 l h S");const cs=a.paths[0].contours[0].commands;
  assert.deepEqual(cs[1],{kind:"line",start:[10,90],end:[10,90]});assert.equal(cs.at(-1)?.kind,"close");
});
test("graphics save/restore retains style, colors, dash and clip membership at paint time",async()=>{
  const a=await inspect("q 0 0 80 80 re W n 0.5 w 1 0 0 RG [2 1] 0 d 10 10 m 30 30 l S Q 100 10 m 130 10 l S");
  assert.equal(a.clips.length,1);assert.deepEqual(a.paths[0].style.strokeRgb,[255,0,0]);assert.equal(a.paths[0].style.lineWidth,0.5);
  assert.deepEqual(a.paths[0].style.dash,[2,1]);assert.deepEqual(a.paths[0].style.clipIds,[a.clips[0].id]);
  assert.deepEqual(a.paths[1].style.clipIds,[]);assert.deepEqual(a.paths[1].style.strokeRgb,[0,0,0]);
  assert(a.conversionRequirements.includes("apply_source_clipping_before_native_conversion"));
});
test("compound even-odd fills keep hole contours together and require reconstruction after omission",async()=>{
  const a=await inspect("10 10 80 80 re 20 20 20 20 re f*");
  assert.equal(a.paths[0].paint.evenOdd,true);assert.equal(a.paths[0].contours.length,2);
  const s=selectDraftingVectorSource(a,a.planSha256,[{recordId:a.paths[0].contours[1].id,reason:"outside_requested_detail",evidence:"Explicit scope excludes this interior contour."}]);
  assert(s.conversionRequirements.includes("rebuild_compound_fill_after_explicit_contour_omission"));
});
test("rotated page coordinates and paper bounds are explicit",async()=>{
  const a=await inspect("10 20 m 30 40 l S",{region:[0,0,100,200]},{rotation:90});
  assert.equal(a.pageWidthPoints,100);assert.equal(a.pageHeightPoints,200);
  assert.deepEqual(a.paths[0].contours[0].commands[1],{kind:"line",start:[20,10],end:[40,30]});
});
test("form matrices and source bounding-box clips survive flattening into paper coordinates",async()=>{
  const a=await inspect("q 1 0 0 1 10 20 cm /X1 Do Q",{}, {form:"0 0 m 10 10 l S"});
  assert.equal(a.paths.length,1);assert.deepEqual(a.paths[0].contours[0].commands[1],{kind:"line",start:[30,70],end:[40,60]});
  assert.equal(a.clips.length,1);assert.equal(a.paths[0].style.clipIds.length,1);
});
test("text retains full content, font, baseline, source/page location and explicit visual limits",async()=>{
  const a=await inspect("BT /F1 10 Tf 20 30 Td (FEEDER - DO NOT INFER SIZE) Tj ET");
  assert.equal(a.text.length,1);assert.equal(a.text[0].text,"FEEDER - DO NOT INFER SIZE");
  assert.deepEqual(a.text[0].baselineTransform,[10,0,0,-10,20,70]);assert.match(a.text[0].fontName??"",/Helvetica/);
  assert(a.conversionRequirements.includes("bind_text_paint_order_and_clipping"));
  const p=pageDraftingVectorSource(a,a.planSha256,"text",0,1);assert.deepEqual(p.records[0],a.text[0]);assert.equal(p.page,1);assert.equal(p.sourceSheet,"M101");
});
test("whole-record pagination includes stable context and never slices a contour",async()=>{
  const a=await inspect("10 10 m 20 10 l 20 20 l h 40 10 m 50 10 l S");
  const p=pageDraftingVectorSource(a,a.planSha256,"contours",0,1),p2=pageDraftingVectorSource(a,a.planSha256,"contours",1,1);
  assert.equal(p.total,2);assert.equal(p.nextOffset,1);assert.equal(p2.nextOffset,null);
  assert.equal((p.records[0] as any).commands.length,4);assert.deepEqual(p.region,[0,0,200,100]);assert.equal(p.sourceLabel,"Reference detail.pdf");
});
test("bounded spatial lookup finds the work area without dumping unrelated contours or losing sheet context",async()=>{
  const a=await inspect("10 10 m 20 10 l 20 20 l h 140 10 m 150 10 l S");
  const p=pageDraftingVectorSource(a,a.planSha256,"contours",0,10,[130,70,160,95]);
  assert.equal(p.sourceRecordCount,2);assert.equal(p.total,1);assert.equal(p.sourceSheet,"M101");assert.equal(p.page,1);
  assert.deepEqual(p.filterRegion,[130,70,160,95]);assert.equal((p.records[0] as any).commands.length,2);
  const empty=pageDraftingVectorSource(a,a.planSha256,"contours",0,10,[60,30,80,50]);assert.equal(empty.total,0);assert.equal(empty.nextOffset,null);
  for(const r of [[0,0,201,100],[5,5,5,10],[-1,0,20,20],[0,0,Infinity,20]])assert.throws(()=>pageDraftingVectorSource(a,a.planSha256,"contours",0,10,r as any),/Filter region/);
});
test("source bytes are not detached by the PDF worker",async()=>{
  const b=pdf("10 10 m 20 20 l S"),before=sha(b);await inspectDraftingVectorSource(b,{expectedSourceSha256:before,page:1,region:[0,0,200,100],sourceLabel:"source.pdf"});
  assert.equal(sha(b),before);assert(b.length>0);
});
test("nonuniform stroke transforms are surfaced for conversion rather than guessed",async()=>{
  const a=await inspect("2 0 0 1 0 0 cm 10 10 m 20 20 l S");
  assert(a.conversionRequirements.includes("resolve_nonuniform_stroke_transform"));
});
test("opacity and other unsupported graphics states are explicit conversion blockers",async()=>{
  const a=await inspect("q /GS1 gs 10 10 m 30 30 l S Q",{}, {extGState:"<< /Type /ExtGState /CA 0.5 >>"});
  assert(a.unsupported.some(u=>u.operator==="setGState"&&u.intersectsRegion));
  assert(a.conversionRequirements.includes("resolve_selected_unsupported_graphics"));assert.equal(a.nativeWriteAllowed,false);
});
test("plan mutation, unknown omission, duplicate omission and unsupported reason fail closed",async()=>{
  const a=await inspect("10 10 m 20 20 l S"),id=a.paths[0].contours[0].id;
  assert.throws(()=>selectDraftingVectorSource(a,a.planSha256,[{recordId:"made-up",reason:"historical_revision",evidence:"cloud"}]),/omission/);
  assert.throws(()=>selectDraftingVectorSource(a,a.planSha256,[{recordId:id,reason:"historical_revision",evidence:""}]),/omission/);
  const o={recordId:id,reason:"historical_revision" as const,evidence:"source cloud"};
  assert.throws(()=>selectDraftingVectorSource(a,a.planSha256,[o,o]),/omission/);
  assert.throws(()=>selectDraftingVectorSource(a,a.planSha256,[{...o,reason:"pretend_verified" as any}]),/omission/);
  const changed=structuredClone(a);changed.paths[0].contours[0].commands=[];
  assert.throws(()=>pageDraftingVectorSource(changed,a.planSha256,"contours",0,1),/hash/);
  assert.throws(()=>selectDraftingVectorSource(changed,a.planSha256,[]),/hash/);
});
test("hash-bound identity changes with source and selected region; no automatic revision removal",async()=>{
  const a=await inspect("10 10 m 20 20 l S"),b=await inspect("10 10 m 20 20 l S",{region:[0,0,100,100]});
  assert.equal(a.sourceSha256,b.sourceSha256);assert.equal(a.paths[0].contours[0].id,b.paths[0].contours[0].id);assert.notEqual(a.planSha256,b.planSha256);
  const s=selectDraftingVectorSource(a,a.planSha256,[]);assert.deepEqual(s.paths,a.paths);assert.deepEqual(s.omissions,[]);
});
test("page/region/hash and paging bounds reject invalid requests",async()=>{
  await assert.rejects(inspect("10 10 m 20 20 l S",{expectedSourceSha256:"0".repeat(64)}),/hash mismatch/);
  await assert.rejects(inspect("10 10 m 20 20 l S",{page:2}),/page exceeds/);
  await assert.rejects(inspect("",{page:0}),/Positive PDF page/);
  for(const region of [[0,0,0,1],[0,0,201,100],[-1,0,20,20],[0,0,NaN,20]])await assert.rejects(inspect("",{region:region as any}),/region|Region/);
  const a=await inspect("10 10 m 20 20 l S");
  for(const [offset,limit]of[[-1,1],[0,0],[0,201],[0.5,1],[2,1]])assert.throws(()=>pageDraftingVectorSource(a,a.planSha256,"contours",offset,limit),/bounds|offset/);
});
