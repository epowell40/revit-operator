import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {compileDraftingCurveCad} from "../src/pdf/drafting_curve_cad.js";
import {canonicalVectorJson,type VectorNativePlan} from "../src/pdf/drafting_vector_native_plan.js";

function plan():VectorNativePlan {
 const p:any={schema:"operator.drafting_vector_native_plan.v1",sourceSha256:"a".repeat(64),sourcePlanSha256:"b".repeat(64),selectionSha256:"c".repeat(64),sourceLabel:"source.pdf",sourceSheet:"M501",page:1,region:[0,0,144,144],layout:{paperWidthInches:2,viewScale:100,partSize:50},paperHeightInches:2,coordinateSpace:"paper inches, right/up, lower-left of selected source region",entities:[{id:"line",sourceId:"source-line",kind:"line",points:[[1,1],[2,1.0000002]]},{id:"cubic",sourceId:"source-curve",kind:"cubic_bezier",points:[[0,0],[1,2],[2,2],[3,0]]},{id:"text",sourceId:"source-text",kind:"text",text:"DO NOT OMIT"}],partCount:1,zeroLengthSourceCommands:0,omissions:[],limits:[],nativeWriteAllowed:false};
 p.nativePlanSha256=crypto.createHash("sha256").update(canonicalVectorJson(p)).digest("hex");return p;
}
function codes(dxf:string){const lines=dxf.trimEnd().split("\n");return Array.from({length:lines.length/2},(_,i)=>[Number(lines[2*i]),lines[2*i+1]] as const);}
test("CAD preserves complete source coordinates and cubic controls without faceting or native authority",()=>{
 const p=plan(),before=canonicalVectorJson(p),a=compileDraftingCurveCad(p,p.nativePlanSha256,["line","cubic"]);
 assert.equal(canonicalVectorJson(p),before);assert.equal(a.wholeDrawing,false);assert.equal(a.nativeWriteAllowed,false);
 assert.equal(a.unselectedEntityCount,1);assert.equal(a.sourceSheet,"M501");assert.equal(a.importUnit,"Foot");
 assert.deepEqual(a.selection[0].points,[[100/12,100/12,0],[200/12,1.0000002*(100/12),0]]);
 assert.deepEqual(a.selection[1].points,p.entities[1].points!.map(([x,y])=>[x*(100/12),y*(100/12),0]));
 const parsed=codes(a.dxf);assert.equal(parsed.filter(([c,v])=>c===0&&v==="LINE").length,1);
 assert.equal(parsed.filter(([c,v])=>c===0&&v==="SPLINE").length,1);
 const splineOffset=parsed.findIndex(([c,v])=>c===0&&v==="SPLINE"),afterSpline=parsed.findIndex(([c],i)=>i>splineOffset&&c===0);
 assert.deepEqual(parsed.slice(splineOffset,afterSpline).filter(([c])=>c===40).map(([,v])=>Number(v)),[0,0,0,0,1,1,1,1]);
 const lineOffset=parsed.findIndex(([c,v])=>c===0&&v==="LINE"),nextOffset=parsed.findIndex(([c],i)=>i>lineOffset&&c===0);
 const line=parsed.slice(lineOffset,nextOffset),value=(code:number)=>Number(line.find(([c])=>c===code)![1]);
 assert.deepEqual([[value(10),value(20),value(30)],[value(11),value(21),value(31)]],a.selection[0].points);
 assert.equal(crypto.createHash("sha256").update(a.dxf).digest("hex"),a.dxfSha256);
});
test("mutated source is rejected even when IDs and the requested selection remain the same",()=>{
 const p=plan();p.entities[0].points![1][1]+=0.1;
 assert.throws(()=>compileDraftingCurveCad(p,p.nativePlanSha256,["line"]),/hash differs/);
});
test("explicit selections never silently omit unsupported or absent entities",()=>{
 const p=plan();for(const ids of [["text"],["missing"],["line","text"],["line","line"],[]])
  assert.throws(()=>compileDraftingCurveCad(p,p.nativePlanSha256,ids));
});
test("dashed source cannot become a solid curve as an unreported fallback",()=>{
 const p=plan();p.entities[0].style={color:[0,0,0],weight:1,sourceWidthPoints:0.24,dashInches:[0.1,0.1],dashPhaseInches:0};
 const {nativePlanSha256,...unsigned}=p;p.nativePlanSha256=crypto.createHash("sha256").update(canonicalVectorJson(unsigned)).digest("hex");
 assert.throws(()=>compileDraftingCurveCad(p,p.nativePlanSha256,["line"]),/Dashed/);
});
test("host geometry scope stays bounded independently of source inventory size",()=>{
 const p=plan();assert.throws(()=>compileDraftingCurveCad(p,p.nativePlanSha256,Array.from({length:65},(_,i)=>String(i))),/1..64/);
 assert.deepEqual(compileDraftingCurveCad(p,p.nativePlanSha256,["cubic"]).selection.map(x=>x.entityId),["cubic"]);
});
test("finite source coordinates that overflow host units cannot emit invalid CAD numbers",()=>{
 const p=plan();p.entities[0].points![0][0]=Number.MAX_VALUE;
 const {nativePlanSha256,...unsigned}=p;p.nativePlanSha256=crypto.createHash("sha256").update(canonicalVectorJson(unsigned)).digest("hex");
 assert.throws(()=>compileDraftingCurveCad(p,p.nativePlanSha256,["line"]),/overflow/);
});
test("DXF table heads and records have distinct stable native handles and exact owners",()=>{
 const p=plan(),a=compileDraftingCurveCad(p,p.nativePlanSha256,["line","cubic"]);
 const records:Array<Array<readonly [number,string]>>=[];
 for (const pair of codes(a.dxf)) {
  if(pair[0]===0)records.push([]);
  records.at(-1)!.push(pair);
 }
 const value=(record:typeof records[number],code:number)=>record.find(([c])=>c===code)?.[1];
 const table=records.find(r=>value(r,0)==="TABLE"&&value(r,2)==="LAYER")!;
 assert.match(value(table,5)??"",/^[1-9A-F][0-9A-F]*$/);
 assert(table.some(([c,v])=>c===100&&v==="AcDbSymbolTable"));
 const layerRecords=records.filter(r=>value(r,0)==="LAYER");assert.equal(layerRecords.length,3);
 for(const record of layerRecords)assert.equal(value(record,330),value(table,5));
 const entities=records.filter(r=>["LINE","SPLINE"].includes(value(r,0)??""));
 const handles=[table,...layerRecords,...entities].map(r=>value(r,5));
 assert(handles.every(h=>h&&/^[1-9A-F][0-9A-F]*$/.test(h)));assert.equal(new Set(handles).size,handles.length);
 assert.equal(compileDraftingCurveCad(p,p.nativePlanSha256,["line","cubic"]).dxf,a.dxf);
});
test("native CAD documents contain real model-space block ownership, not only loose entities",()=>{
 const p=plan(),a=compileDraftingCurveCad(p,p.nativePlanSha256,["line","cubic"]);
 const records:Array<Array<readonly [number,string]>>=[];
 for(const pair of codes(a.dxf)){if(pair[0]===0)records.push([]);records.at(-1)!.push(pair);}
 const value=(r:typeof records[number],code:number)=>r.find(([c])=>c===code)?.[1];
 const model=records.find(r=>value(r,0)==="BLOCK_RECORD"&&value(r,2)==="*Model_Space");
 assert(model,"Native model-space block record is required; clean curve geometry alone is insufficient.");
 const handle=value(model,5);assert(handle);
 assert(records.some(r=>value(r,0)==="BLOCK"&&value(r,2)==="*Model_Space"&&value(r,330)===handle));
 const entities=records.filter(r=>["LINE","SPLINE"].includes(value(r,0)??""));assert.equal(entities.length,2);
 for(const entity of entities)assert.equal(value(entity,330),handle);
});
