import assert from "node:assert/strict";
import test from "node:test";
import { projectDrawingObservableTruth, type DrawingObservabilityPolicyV1 } from "../src/existing_conditions/drawing_observability.js";
import type { ExistingConditionsSnapshot } from "../src/existing_conditions/model_contract.js";
const hash="a".repeat(64);
test("drawing observability projects attributes without modifying native truth or accepting geometry waivers",()=>{
  const snapshot:ExistingConditionsSnapshot={native_readback:true,open_connector_count:0,elements:[
    {key:"duct",kind:"mep_curve",category:"Ducts",discipline:"mechanical",size:{diameter_ft:1}},
    {key:"symbol",kind:"family_instance",category:"Air Terminals",discipline:"mechanical",family:"Hidden",size:{width_ft:1},parameters:{Airflow:100}}
  ],connections:[{a:"duct",b:"symbol",kind:"physical"}]};
  const policy:DrawingObservabilityPolicyV1={schema_version:1,source_evidence_sha256:hash,elements:[{key:"symbol",existence:"ambiguous",unobserved_attributes:["family","size","parameters"],reason:"Unlabeled record symbol"}]};
  const original=structuredClone(snapshot);
  const result=projectDrawingObservableTruth(snapshot,policy,[{sha256:hash}]);
  assert.deepEqual(result.invalidReasons,[]);assert.deepEqual([...result.ambiguousKeys],["symbol"]);
  assert.equal(result.elements[1]!.size,undefined);assert.equal(result.elements[0]!.size!.diameter_ft,1);
  assert.deepEqual(snapshot,original);
  for(const edit of [
    (p:any)=>p.elements.push(p.elements[0]),
    (p:any)=>p.elements[0].key="duct",
    (p:any)=>p.elements[0].reason="",
    (p:any)=>p.elements[0].unobserved_attributes=["endpoints"],
    (p:any)=>p.source_evidence_sha256="b".repeat(64)
  ]){const p=structuredClone(policy);edit(p);assert.ok(projectDrawingObservableTruth(snapshot,p,[{sha256:hash}]).invalidReasons.length);}
  snapshot.connections=[];
  assert.ok(projectDrawingObservableTruth(snapshot,policy,[{sha256:hash}]).invalidReasons.includes("drawing_observability_ambiguous_symbol_invalid"));
});
