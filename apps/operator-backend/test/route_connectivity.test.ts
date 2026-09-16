import test from "node:test";
import assert from "node:assert/strict";
import { physicalRouteConnectivity } from "../src/existing_conditions/route_connectivity.js";
import type { ExistingConditionsElement, ExistingConditionsSnapshot } from "../src/existing_conditions/model_contract.js";

const duct=(key:string,a:number,b:number):ExistingConditionsElement=>({key,kind:"mep_curve",discipline:"mechanical",category:"Ducts",endpoints:[{x:a,y:0,z:10},{x:b,y:0,z:10}]});
test("physical route grading accepts connected segmentation and rejects breaks, logical links and orphan fittings",()=>{
  const truth:ExistingConditionsSnapshot={native_readback:true,elements:[duct("t",0,20)],connections:[],open_connector_count:2};
  const candidate:ExistingConditionsSnapshot={native_readback:true,elements:[duct("a",0,10),duct("b",10,20)],connections:[{a:"a",b:"b",kind:"physical"}],open_connector_count:2};
  const score=()=>physicalRouteConnectivity(truth,candidate,new Set(["t"]),new Set(["a","b"]),[],0.25);
  assert.equal(score(),1);
  candidate.connections=[];assert.equal(score(),0);
  candidate.connections=[{a:"a",b:"b",kind:"system"}];assert.equal(score(),0);
  candidate.connections=[{a:"a",b:"b",kind:"physical"}];candidate.open_connector_count=4;assert.equal(score(),0);
  candidate.open_connector_count=2;candidate.elements.push({key:"orphan",kind:"fitting",discipline:"mechanical",category:"Duct Fittings"});assert.equal(score(),0);
  candidate.connections.push({a:"a",b:"orphan",kind:"physical"});assert.equal(score(),1);
});

test("physical route grading rejects joining separate systems and losing terminal connections",()=>{
  const truth:ExistingConditionsSnapshot={native_readback:true,elements:[duct("t1",0,10),duct("t2",10,20),{key:"device",kind:"family_instance",category:"Air Terminals"}],connections:[{a:"t1",b:"device"}],open_connector_count:3};
  const candidate:ExistingConditionsSnapshot={native_readback:true,elements:[duct("c1",0,10),duct("c2",10,20),{key:"newdevice",kind:"family_instance",category:"Air Terminals"}],connections:[{a:"c1",b:"newdevice"}],open_connector_count:3};
  const score=()=>physicalRouteConnectivity(truth,candidate,new Set(["t1","t2"]),new Set(["c1","c2"]),[{truth_key:"device",candidate_key:"newdevice"}],0.25);
  assert.equal(score(),1);
  candidate.connections.push({a:"c1",b:"c2"});assert.equal(score(),0);
  candidate.connections=[];assert.equal(score(),0);
});
