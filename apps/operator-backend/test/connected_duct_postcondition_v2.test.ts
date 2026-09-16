import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { openDuctReadbackMatchesV2 } from "../src/verification/open_duct_postcondition_v2.js";
const fixture=():any=>JSON.parse(fs.readFileSync("test/fixtures/c37-connected-duct-readback.json","utf8"));
const matches=(f:any)=>openDuctReadbackMatchesV2(f.input,f.affected,f.parameters,f.connectors);

test("retained C38 correctly located round duct with two open physical ends is not a completed connected reconstruction",()=>{
  const f=JSON.parse(fs.readFileSync("test/fixtures/c38-disconnected-round-duct-readback.json","utf8"));
  const subject=f.connectors.results.find((r:any)=>r.id===1542942);
  assert.ok(subject);assert.equal(subject.connectors.length,2);
  assert.ok(subject.connectors.every((c:any)=>c.isPhysicallyConnected===false&&c.physicalConnectedTo.length===0));
  assert.equal(matches(f),false);
  // Adapt the request to the supported atomic connected-route contract and
  // select just the subject from the evaluator's three-element readback.
  // Recompute page counts from those retained rows; do not change connectors.
  const p=f.input.body;
  f.input=fixture().input;
  Object.assign(f.input.body,{levelId:p.levelId,systemType:p.systemType,ductTypeId:p.ductTypeId,ductShape:"round",diameter:p.diameter,points:[{x:p.startX,y:p.startY,z:p.startZ},{x:p.endX,y:p.endY,z:p.endZ}]});
  f.parameters.items=f.parameters.items.filter((r:any)=>r.id===1542942);
  Object.assign(f.connectors,{results:[subject],requestedCount:1,scannedElementCount:1,matchedElementCount:1,totalScannedConnectorCount:2,physicallyConnectedConnectorCount:0,openPhysicalConnectorCount:2});
  assert.equal(matches(f),false);
});

test("retained C37 connected round exhaust route can finish from complete native readback",()=>{
  const f=fixture();
  assert.equal(matches(f),true);
  f.connectors.results[0].connectors.reverse();
  assert.equal(matches(f),true,"native enumeration order is not routing order");
});

test("connected route requires actual geometry, dimensions, system and two physical external ends",()=>{
  for(const [name,change] of [
    ["wrong elevation",(f:any)=>f.connectors.results[0].connectors[0].origin[2]+=1],
    ["wrong diameter",(f:any)=>f.parameters.items[0].parameters.Diameter="0.5"],
    ["wrong connector size",(f:any)=>f.connectors.results[0].connectors[1].size.radiusFt=0.25],
    ["wrong classification",(f:any)=>f.connectors.results[0].connectors[1].systemClassification="SupplyAir"],
    ["wrong level",(f:any)=>f.parameters.items[0].parameters["Reference Level"]="1"],
    ["wrong type",(f:any)=>f.connectors.results[0].typeId++],
    ["disconnected",(f:any)=>f.connectors.results[0].connectors[1].isPhysicallyConnected=false],
    ["empty refs",(f:any)=>f.connectors.results[0].connectors[1].physicalConnectedTo=[]],
    ["self connection",(f:any)=>f.connectors.results[0].connectors[0].physicalConnectedTo[0].ownerId=1542945],
    ["logical-only",(f:any)=>f.connectors.results[0].connectors[1].physicalConnectedTo[0].isMepSystem=true],
    ["contradictory refs",(f:any)=>f.connectors.results[0].connectors[1].connectedTo[0].ownerId=12],
    ["open summary",(f:any)=>f.connectors.openPhysicalConnectorCount=1],
    ["truncated",(f:any)=>f.connectors.results[0].connectorScanTruncated=true],
    ["duplicate ends",(f:any)=>f.connectors.results[0].connectors[1]=structuredClone(f.connectors.results[0].connectors[0])],
    ["other affected work",(f:any)=>f.affected.push("element_id:99")],
    ["implicit height",(f:any)=>delete f.input.body.points[1].z],
    ["mixed coordinates",(f:any)=>f.input.body.points[0].xyz=[1,2,3]],
    ["extra effect",(f:any)=>f.input.body.insulationThickness=1],
    ["only optional connection",(f:any)=>f.input.body.requireExistingEndpointConnections=false],
    ["preview",(f:any)=>f.input.body.apply=false],
    ["unsupported branch",(f:any)=>f.input.body.points.push({x:1,y:2,z:3})],
    ["forged report",(f:any)=>f.connectors={report:f.connectors,verified:true}]
  ] as Array<[string,(f:any)=>void]>){const f=fixture();change(f);assert.equal(matches(f),false,name);}
});

test("connected rectangular neighbor and equivalent explicit world coordinates share the native checks",()=>{
  const f=fixture();
  f.input.body.ductShape="rectangular";f.input.body.ductSize="12x10";delete f.input.body.diameter;
  for(const p of f.input.body.points){p.xyz=[p.x,p.y,p.z];delete p.x;delete p.y;delete p.z;}
  f.parameters.items[0].parameters.Width="1";f.parameters.items[0].parameters.Height=String(10/12);delete f.parameters.items[0].parameters.Diameter;
  for(const c of f.connectors.results[0].connectors){c.shape="Rectangular";c.size={kind:"rect",widthFt:1,heightFt:10/12};}
  assert.equal(matches(f),true);
  f.connectors.results[0].connectors[1].size.heightFt=1;
  assert.equal(matches(f),false);
});
