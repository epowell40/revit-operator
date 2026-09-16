import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { openDuctReadbackMatchesV2 } from "../src/verification/open_duct_postcondition_v2.js";
import { postconditionSatisfiedByPayloadV2 } from "../src/postcondition_verification_v2.js";
import { verificationCapabilityGuidanceV2 } from "../src/verification/verification_capability_admission_v2.js";
const fixture = (): any => JSON.parse(fs.readFileSync("test/fixtures/c35-open-duct-readback.json", "utf8"));
const matches = (f: any) => openDuctReadbackMatchesV2(f.input, f.affected, f.parameters, f.connectors);

test("retained C35 parameters alone cannot verify the route; complete independent native geometry can", () => {
  const f = fixture();
  assert.equal(postconditionSatisfiedByPayloadV2(f.input, f.parameters), false);
  assert.equal(openDuctReadbackMatchesV2(f.input, f.affected, f.parameters, {}), false);
  assert.equal(matches(f), true);
  f.connectors.results[0].connectors.reverse();
  assert.equal(matches(f), true, "connector enumeration order has no geometric meaning");
  assert.match(verificationCapabilityGuidanceV2({path:f.input.path})!, /first POST.*get-parameters.*then POST.*get-connectors/);
});

test("wrong geometry, type, level, system, dimensions, partial rows or connected ends do not verify", () => {
  const cases: Array<[string,(f:any)=>void]> = [
    ["wrong endpoint",f=>f.connectors.results[0].connectors[0].origin[0]+=1],
    ["wrong elevation",f=>f.connectors.results[0].connectors[1].origin[2]+=1],
    ["wrong type",f=>f.connectors.results[0].typeId++],
    ["wrong level",f=>f.parameters.items[0].parameters["Reference Level"]="1"],
    ["wrong system",f=>f.parameters.items[0].parameters["System Classification"]="Return Air"],
    ["wrong size",f=>f.connectors.results[0].connectors[0].size.widthFt=2],
    ["connected",f=>f.connectors.results[0].connectors[0].isConnected=true],
    ["connected references",f=>f.connectors.results[0].connectors[0].connectedTo.push({id:99})],
    ["truncated",f=>f.connectors.connectorScanTruncatedElementCount=1],
    ["missing endpoint",f=>f.connectors.results[0].connectors.pop()],
    ["duplicate row",f=>f.parameters.items.push(f.parameters.items[0])],
    ["foreign target",f=>f.affected=["element_id:1"]],
    ["model report",f=>f.connectors={report:f.connectors,verified:true}],
    ["unsupported mixed effects",f=>f.affected.push("element_id:2")],
    ["unsupported connected route",f=>f.input.body.connectToExisting=true],
    ["unsupported extra effect",f=>f.input.body.insulationThickness=1],
    ["preview",f=>f.input.body.apply=false],
    ["zero size",f=>f.input.body.ductSize="0x10"],
    ["degenerate",f=>f.input.body.points[1]=f.input.body.points[0]]
  ];
  for(const [name,change] of cases){const f=fixture();change(f);assert.equal(matches(f),false,name);}
});

test("C36 pixel elevation failure never verifies; explicit world duct intent accepts only matching native readback", () => {
  const retained=JSON.parse(fs.readFileSync("test/fixtures/c36-open-duct-wrong-elevation.json","utf8"));
  assert.equal(matches(retained),false);
  const intended=structuredClone(retained);
  intended.input.body.startPoint={xyz:[...retained.connectors.results[0].connectors[1].origin.slice(0,2),retained.input.body.startPoint.z]};
  intended.input.body.endPoint={xyz:[...retained.connectors.results[0].connectors[0].origin.slice(0,2),retained.input.body.endPoint.z]};
  assert.equal(matches(intended),false,"retained native wrong-height geometry remains a failure");
  // Synthetic corrected neighbor tests the contract; it is not live qualification.
  for(const end of intended.connectors.results[0].connectors)end.origin[2]=retained.input.body.startPoint.z;
  assert.equal(matches(intended),true,"native auto-selected type is explicit in authoritative readback");
  intended.input.body.ductTypeId=intended.connectors.results[0].typeId;
  assert.equal(matches(intended),true);
  for(const [label,change] of [
    ["wrong explicit type",(f:any)=>f.input.body.ductTypeId++],
    ["missing native type",(f:any)=>delete f.connectors.results[0].typeId],
    ["mixed coordinates",(f:any)=>f.input.body.startX=1],
    ["extra effect",(f:any)=>f.input.body.insulationThickness=1],
    ["preview",(f:any)=>f.input.body.dryRun=true],
    ["wrong height",(f:any)=>f.connectors.results[0].connectors[0].origin[2]-=12],
    ["omitted elevation",(f:any)=>f.input.body.startPoint.xyz.pop()]
  ] as Array<[string,(f:any)=>void]>){const f=structuredClone(intended);change(f);assert.equal(matches(f),false,label);}
  const flat=structuredClone(intended);for(const prefix of ["start","end"]){for(const [i,axis]of ["X","Y","Z"].entries())flat.input.body[prefix+axis]=flat.input.body[prefix+"Point"].xyz[i];delete flat.input.body[prefix+"Point"];}
  assert.equal(matches(flat),true);
});
