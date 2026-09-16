import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { openDuctReadbackMatchesV2 } from "../src/verification/open_duct_postcondition_v2.js";
const fixture=():any=>JSON.parse(fs.readFileSync("test/fixtures/c37-connected-duct-readback.json","utf8"));
const matches=(f:any)=>openDuctReadbackMatchesV2(f.input,f.affected,f.parameters,f.connectors);

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
